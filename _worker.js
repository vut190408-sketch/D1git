// --- HÀM CHUYỂN ĐỔI JSON (Đã nâng cấp để đọc được Object Options) ---
    function flattenQuestions(list, quizId, parentId = null, order = { v: 0 }) {
      const qRows = [], oRows = [];
      for (const q of list) {
        qRows.push({
          question_id: q.id, 
          quiz_id: quizId, 
          parent_id: parentId,
          type: q.type || "multiple_choice",
          content: q.question || q.cau_hoi || "",
          material: q.materials ? JSON.stringify(q.materials) : null,
          sort_order: order.v++,
        });
        
        let opts = [];
        
        // 1. Dạng True/False đặc thù có statements
        if (q.type === "multiple_true_false" && q.statements) {
          opts = q.statements.map(st => ({ id: st.id, content: st.text, is_correct: st.answer }));
        } 
        else {
          // 2. Dạng options thông thường
          if (Array.isArray(q.options)) {
            // Nếu options là Mảng: [ {id: "A", content: "..."} ]
            opts = q.options.map(o => ({ 
                id: o.id, 
                content: o.content || o.text, 
                is_correct: (q.correct_answers || []).includes(o.id) 
            }));
          } else if (q.options && typeof q.options === 'object') {
            // Nếu options là Đối tượng: { "A": "...", "B": "..." } (NHƯ JSON CỦA BẠN)
            opts = Object.entries(q.options).map(([key, val]) => ({ 
                id: key, 
                content: val, 
                is_correct: (q.correct_answers || []).includes(key) 
            }));
          }
        }

        // Đẩy vào mảng để insert SQL
        opts.forEach((o, idx) => {
          oRows.push({ 
              option_id: o.id, 
              question_id: q.id, 
              content: o.content, 
              is_correct: o.is_correct ? 1 : 0, 
              sort_order: idx 
          });
        });
      }
      return { qRows, oRows };
    }
